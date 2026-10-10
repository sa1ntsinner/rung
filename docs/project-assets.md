# Project assets

The V20 CLI and VS Code commands **Rung: Project Assets** and **Rung: Project
Assets: Review and Apply** share the same preview and guarded apply operations.
Choose the PLC explicitly. Review the diff before applying; dirty or changed
artifact files refuse. Workspace writes and import policies, project ownership,
exclusive transactions, operation IDs and existing save policy still apply.
These commands edit the offline engineering project. They do not download it.

## Alarm text lists

```sh
rung alarms --device PLC_1 --export alarms.xlsx --json
rung alarms --device PLC_1 --file alarms.xlsx --preview --json
rung alarms --device PLC_1 --file alarms.xlsx --apply --expected-revision <project-revision> --expected-artifact-revision <artifact-sha256> --json
```

Export creates a new file. Keep the complete native `TextList` and
`TextListEntry` sheets, row order, identities, ranges and language headers.
The initial scope changes existing Text and Comment cells only, in active
project languages. Creating/deleting lists, changing ranges or activating
languages is unavailable. Formulas, external links, rich strings, malformed
parts and oversized workbooks refuse before import. A missing provider or an
empty native text-list service reports unavailable; no empty workbook is invented.
TIA must return an entirely successful import result. The complete semantic
text state and surrounding project state are checked before commit and again
after the transaction. Failed restoration is reported explicitly.

## Technology objects

```sh
rung technology --device PLC_1 --name RungPID_Probe --export pid.xml --json
rung technology --device PLC_1 --name RungPID_Probe --file pid.xml --preview --json
rung technology --device PLC_1 --name RungPID_Probe --file pid.xml --apply --expected-revision <project-revision> --expected-artifact-revision <artifact-sha256> --json
rung compile --plc PLC_1
```

The proven initial scope is a compiled root **PID_Compact 2.3** object and its
writable Real **Config.InputUpperLimit.StartValue**. Preserve every other native
XML field. Other TO versions, parameters, nesting, object creation and deletion
refuse. Read-only gain parameters are not editable. Removing this StartValue
restores the version-pinned native implicit value 120.

Native Override import replaces object handles and makes the TO inconsistent.
The adapter reacquires it and verifies its complete parameter inventory, identity
and surrounding project state. TIA cannot export inconsistent objects or compile
inside a transaction: compilation is a separate explicit action. Full native XML
restoration was checked after compilation on the disposable fixture; the apply
receipt itself proves the parameter/state checks, not a compiled XML export.
Artifact mutation currently requires a project with one PLC.

## Safety observation

```sh
rung safety --device PLC_1 --json
```

Read-only offline engineering observation returns a status, source and explicit
availability of the native block signature and system version. Unknown, empty
or inaccessible signature services never become an empty valid approval.
The available local fixture is not an F project: actual CLI/editor acceptance
therefore verified **unavailable**, not a positive F signature or safety approval.
No safety editing, PLC signature comparison or safety download is exposed.

## Hardware and libraries

Hardware YAML/JSON snapshots support guarded edits of writable text, true/false
and whole-number attributes, and creating or deleting catalogue modules where TIA
Portal says they plug. Identity attributes and read-only ones refuse. Existing network YAML remains separate.
See [libraries](libraries.md) for native package import, release and the bounded
used-instance version update. Neither import nor release silently updates instances.
