<!-- SPDX-License-Identifier: MIT -->
# Native library packages

`rung library` lists a concise inventory with native GUIDs, versions and states when available. `--json` returns the full native tree, including technical metadata. Preview, import, export, release and update results retain their detailed format.

```powershell
rung library --json
rung library --file Type.libinfo --json
rung library --file Type.libinfo --preview --device PLC_1 --json
rung library --file Type.libinfo --apply --device PLC_1 --expected-revision <preview.revision> --expected-package-revision <preview.package.revision> --json
rung library --type-guid <uuid> --version-guid <uuid> --export ./new-package --json
```

Listing exposes native type and version GUIDs in the existing library tree.
Export selects a project-library version by those GUIDs, holds TIA exclusive
access, and uses its native XML/libinfo serializer. The new destination directory
contains `type.xml` and `type.libinfo`; existing directories refuse. Native files
travel as bounded binary base64 and retain their exact bytes. Export performs no
project save, release, instance update or PLC operation. V21 exports refuse until
independently validated.

This inspects the native V20 `Type.libinfo` and adjacent `Type.xml` pair without
opening a TIA project. It preserves raw bytes, including XML UTF-8 BOM and CRLF,
and checks the native document SHA256, source type/version GUIDs, version number,
state and supported XML domain. The result includes a revision of the raw pair.
Missing files, duplicate/unknown metadata fields, invalid names/base64/hashes,
DTD/external entities, extra native objects and unsupported domains refuse.

The initial supported package is one released default dependency-free V20 FB/FC
library version in native XML with its unchanged metadata. Total raw size is
4 MiB, metadata at most 1 MiB; names use 1–64 ASCII letters, digits or `-`/`_`.
Other formats, nondefault/InWork versions, dependencies and target-device
requirements remain unsupported. Native `LibraryMetaFileHash` is opaque: this
inspection checks its representation. Native import does not establish an
independent integrity check of that hash; the raw document hash and whole-pair
revision are checked separately. Inspection does not establish native acceptance.

Import preview validates the package before opening TIA, resolves the selected
PLC root, then checks project-library type/name/version collisions and existing
block names under exclusive access. Preview/import initially support only an
unprotected LAD FB without a namespace; software-unit targets are unavailable.
Preview does not import, save, release or rename objects; its result explicitly
reports `nativeImportValidated: false`. Its `revision` covers bounded library and
hardware graphs plus freshly read engineering object revisions and native
library bindings across the PLCs; listing-cache revisions are not used to approve
changes. It is an engineering revision, not a whole-project byte snapshot.

Apply requires both hashes from a reviewed preview, `rung writes on` and
`sync.import = "auto"`. It stages the unchanged native files, rechecks the project
under exclusive access, rejects reused operation IDs, and calls native
`CreateFromDocuments` with the selected PLC root as the test environment.
Before commit, only one new project type and one new LAD FB are permitted;
unrelated objects must retain their observed identities/revisions/bindings.
The committed state must match the validated state. On error, native rollback is
checked; restoration failures are reported explicitly. No guessed deletes or
default values are used to recover a failed product import.

The result reports the actual type/version GUID, `InWork` 0.0.1, FB address and
new engineering revision. Save follows the existing `sync.save` policy and is
reported by `saved` with any save warning. There is no automatic release, instance
update, PLC connection or download. Native import acceptance does not prove the
new FB has been tested or that a version is ready for release.

The source version GUID identifies the exported version. Actual native
`CreateFromDocuments` on the disposable RungProve clone preserved type GUID
but created a new version GUID in `InWork` 0.0.1. Import cannot promise to restore
the source released version number/GUID; explicit release is a separate action.
The native API requires `PlcBlockGroup` as a PLC test environment and refuses
existing block-name collisions. Product inspection does not import, release or
update any type or instance.

Native release/export and document import were observed on a disposable offline
copy. A used FB with one definition preserved its name and binding while native
`UpdateProject` moved it from 1.0.0 to 1.1.0. TIA's default library settings delete
unused type instances, and native updates can consolidate aliases. These broader
cases are not exposed as product update operations. See the
[Siemens V20 library update settings](https://docs.tia.siemens.cloud/r/en-us/v20/using-libraries/using-types-and-their-versions/working-with-types-in-the-project-library/updating-the-project-to-the-latest-versions).
Each failed probe verified rollback of library/hardware graphs, all block names
and the original source XML bytes, then closed without save. Robot and original
UI were untouched; source archive hash stayed identical.

Release is explicit and separate from import:

```sh
rung compile --plc PLC_1
rung library --release --type-guid <type> --version-guid <in-work-version> --number 1.0.0 --author smile --comment "Reviewed" --preview --json
rung library --release --type-guid <type> --version-guid <in-work-version> --number 1.0.0 --author smile --comment "Reviewed" --apply --expected-revision <preview-revision> --json
```

The initial V20 scope is one dependency-free InWork version with one compiled,
unprotected LAD FB test instance in a PLC root, no namespace and at most one
comment language. Multi-version edited test environments refuse. Release does
not automatically create/release dependencies or update other instances.
It uses the existing writes, operation UUID, exclusive transaction and save
policies. The result contains the actual **new** native released-version GUID.

Before commit, the exported FB definition is compared with the ContentObject in
the native released-version export. Only serializer object IDs and the wrapper
are normalized; logic UIds, declaration values and text remain significant.
TIA changes FB dates and consistency during release, so these dates do not
substitute for the definition comparison. Other project objects must retain
their observed revisions and bindings; committed state is rechecked.
Compilation is a separate prerequisite: TIA forbids compilation in a transaction.

Native rollback is verified. Failed release transactions have been observed to
leave a derived library-folder status changed; that produces an explicit
`RESTORATION FAILED` error rather than a claim of successful restoration.
Actual guarded bridge release and disposable-copy cleanup/compilation passed.
Instance update is a separate guarded action:

```sh
rung library --update --device PLC_1 --type-guid <type> --version-guid <default-version> --preview --json
rung library --update --device PLC_1 --type-guid <type> --version-guid <default-version> --apply --expected-revision <preview-revision> --json
rung compile --plc PLC_1
```

The initial scope is two released dependency-free versions of one root LAD FB,
one used definition and one consistent root instance DB in the selected PLC.
Source and target native definitions must match after normalizing only native
serializer IDs and instantiation Name/Number/AutoNumber. Changed logic/defaults,
unused definitions, aliases, nested definitions, additional instances or cross-PLC
uses refuse. Native project updates can delete unused instances or consolidate
aliases, so broader updates are deliberately unavailable. No global TIA setting
is changed. The target version must be the explicit current default.

The adapter checks native source/target definitions and all project/library
bindings before mutation. Only the reviewed FB binding and native consistency
change are accepted; the instance DB and surrounding objects remain unchanged.
State is rechecked after commit and failures verify native rollback. Compilation
is separate because TIA forbids it inside a transaction. Actual bridge, CLI and
VS Code used-instance updates passed on disposable offline clones with source
and project graph restoration. See [project assets](project-assets.md) for other
artifact commands and the safety availability limitation.
