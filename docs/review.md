# Review a PLC change

`rung review` writes a change report for the person who approves it. It reads git and the mirrored sources only; it never starts TIA Portal or connects to a PLC.

```sh
rung review --md
rung review --base main --json
rung review main..feature --md
rung review --base HEAD~1 --head HEAD --json
```

Without a target revision it compares the working tree, including untracked sources, with HEAD (or `--base`). A range compares its two commits and excludes working tree edits. Run the command inside the workspace. Markdown is the default; JSON contains the same evidence. MCP clients use the read-only `rung_review` tool with `base` and optional `head`, and `offset`/`limit` for changed objects.

For each block the report lists interface changes, declaration changes (including constants, start values and retention), changed SCL regions or LAD networks, callers, related data blocks, tags and static dependants. It uses dependencies from both versions, so deleting a block still shows its users. Renamed files appear as a deletion and an addition. DB member order and nested layouts count as interface changes. Large logic excerpts are explicitly marked as truncated; inspect the full git diff for those sections.

The report flags protected objects and names such as `Enable`, `Interlock` and `E_Stop` for attention. These are name matches, not a safety check. Data layout warnings mean a download may reinitialise values; check memory reserve and retained values in TIA Portal.

The compile section contains cached diagnostics from the last sync, when available. Those messages do not prove the current changes compiled. Review does not run tests or claim coverage or behavioural equivalence. Obtain that evidence separately with `rung test`, `rung test --coverage lcov.info` and `rung test --against <base>`. The person reviews the evidence and runs any download or online change themselves.
