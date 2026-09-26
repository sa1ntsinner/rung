<!-- SPDX-License-Identifier: MIT -->
# tree-sitter-scl

A [tree-sitter](https://tree-sitter.github.io/) grammar for **Siemens SCL** (the Structured Control Language of TIA Portal, an IEC 61131-3 Structured Text dialect): `FUNCTION_BLOCK`, `FUNCTION`, `ORGANIZATION_BLOCK`, `DATA_BLOCK` and `TYPE` sources, attribute pragmas, `#locals`, `"globals"`, typed literals (`T#1s`, `16#FF`), `REGION`s and case-insensitive keywords.

Queries: `highlights.scm`, `folds.scm`, `indents.scm`, `outline.scm` (Zed), `locals.scm`.

Part of [rung](https://github.com/sa1ntsinner/rung). MIT licensed.

```
npm install
npx tree-sitter generate
npx tree-sitter test
```
