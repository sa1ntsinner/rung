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
`TextListEntry` sheets, identities, ranges and language headers. Text and
Comment cells change in active project languages; new rows add lists (range
`Decimal`) and entries of a list in the file, and the preview marks them
`added`. A PLC without text lists starts from nothing: export a workbook from
another project, or keep one, and its lists are created. Deleting lists or
entries, changing a range or activating languages is unavailable. TIA's own
row order after import does not count as a change. Formulas, external links, rich strings, malformed
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

Export any compiled root technology object. In the exported XML, set or change
`StartValue` of any parameter (`Config.InputUpperLimit`, `Config.InvertControl`,
nested members by their path); the preview lists each one. A parameter changes
only when TIA Portal lets it be written and the value fits its elementary type
(Bool, integers, Real/LReal, String); every parameter of the object is checked
after the import. Preserve every other native XML field. Removing a StartValue
(an unshown default), object creation and deletion refuse. Proven live on
PID_Compact 2.3.

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
