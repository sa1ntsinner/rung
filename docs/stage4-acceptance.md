# Stage 4 acceptance evidence

Date: 2026-10-09. Stage 4 provides the following **bounded V20** offline
engineering workflows through CLI and VS Code. Wider unproven operations refuse.

| Domain | Proven operation | Initial limit |
| --- | --- | --- |
| Hardware | YAML/JSON preview and guarded attributes/module apply | Comment/Author; SM521 V1.0, Rail_0 slot 2 |
| Libraries | Binary package inspect/export/import, explicit release/update | Dependency-free root LAD FB; initial InWork release; two equal-definition released versions with one used FB and one DB |
| Alarm texts | Native XLSX export, reviewed edit and import | Existing complete text-list/entry identities, active languages, Text/Comment cells only |
| Technology | Native XML export, reviewed edit and import | Compiled root PID_Compact 2.3; Config.InputUpperLimit only |
| Safety | Read-only status/signature/system-version observation | Actual non-F fixture reports unavailable; positive F signature unverified |

Actual disposable RungProve proofs exercised native TIA operations rather than
fabricated serializer fixtures. Hardware annotation/module changes were applied,
compiled and reversed. Native library packages retained raw bytes and document
hashes; import's new InWork GUID and release's new released-version GUID were
checked explicitly. A used FB updated versions while its instance DB retained
identity/state. Alarm Text edits were reversed semantically; technology XML was
restored byte-for-byte after explicit compilation. All domain UI paths passed
in an actual VS Code extension host. No PLC connection, write or download was
used for these proofs.

Native side effects remain explicit: importing/releasing/updating can mark
objects inconsistent; TIA compilation is separate from the transaction. Some
failed releases can leave a derived folder status changed, producing
`RESTORATION FAILED`, never a successful rollback receipt. Technology apply
checks the complete parameter inventory and surrounding project state; compiled
native XML is checked separately. This does not establish support for arbitrary
libraries, TOs or safety configurations.

Regression coverage includes malformed/oversized artifacts, unknown/read-only
fields, stale revisions, operation-ID reuse, unrelated project changes,
postcommit drift and failed restoration. Final review's two Important editor
findings were fixed: workspace/configuration drift between preview and apply,
and unbounded artifact hashing. Tests observed both failures before the fixes.
Malformed workbook relationships, missing service parts, styles, hidden DTDs
and Windows dirty-document identity also received explicit guards.

Final full suites: **344 tests each on net48 and net10**, **1576 TypeScript tests
passed / 28 skipped**, V20/V21 release builds, lint and editor type/build checks
passed. Skipped tests retain their existing environment prerequisites.

Distribution acceptance rebuilt Windows ZIP, npm tarball and VSIX, checked all
SHA256SUMS entries, matching embedded CLI/core bridge bytes and contributed
editor commands. No Siemens binaries were included. The packaged executable
and its packaged V20 bridge read actual hardware/library/safety state and
released the clone; npm CLI parsed an actual native library package. These are
local build/installation checks; no package was published.

The immutable source archive SHA256 is
`5CD13193688B7F080EA6FDF3E21B0627DB92CB656068FF73E7D20D63BB417FEA`.
Both closed disposable baselines matched every one of its **24 original file
hashes**. Added logs/workspace files are outside that comparison. Original TIA
UI processes remained open. Detailed probe logs and artifacts are retained in
`.superpowers/sdd/item4-codex`; supported commands and limitations are documented
in [project assets](project-assets.md) and [libraries](libraries.md).

Final acceptance after review fixes: `editor-probe-actual-4.log` exited 0;
`editor-artifacts-4/editor-actual.log` recorded 1 passing actual-editor test
(97.5 seconds). Native cleanup restored the source XML, block names and complete
hardware/library graphs with zero compile errors; close without save then
restored both baselines' 24 original file hashes. Probe 3 was discarded after
a concurrent same-name Openness whitelist registration blocked its bridge;
probe 4 ran serially with the correct executable registration. Original UI
processes were retained; no registration permissions were broadened.

Stage 4 is complete in the supported scope above. Implementation commit:
`2f3166f`. Packaged CLI SHA256:
`64e5f69308944484d978b435ef0f29639605ec0f8a94ad7925b32dcea84a5b52`.
ZIP/npm/VSIX checksums are in `dist/release/SHA256SUMS.txt`. Automatic continuation
remains disabled; stage 5 trace work has not started.
