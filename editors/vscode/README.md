# rung for VS Code

SCL editing and TIA Portal sync for [rung](https://github.com/sa1ntsinner/rung). The extension is a front end for the `rung` CLI: every button runs a `rung` command, so what you do here is what you would type in a terminal.

## What you get

- **Language support** for `.scl`, `.db`, `.udt`, `.awl` (and TwinCAT / plain IEC ST files): highlighting, completion, hover, go to definition, references, rename of locals, outline, and diagnostics from the parser and from TIA Portal compiles.
- **rung sidebar** (the ladder-rung icon in the activity bar):
  - *Project*: the mirrored objects from `.rung/state.json`, by PLC, kind and TIA folder (or by block type). Conflicts, local or TIA changes and read-only objects are marked. Click to open; right-click to compile, test, open in TIA Portal or resolve a conflict.
  - *PLC*: whether `rung watch` runs (start/stop), each PLC with its online state and connection, and Go online, Go offline, Compile PLC, Compile hardware, Connect…, Interfaces…, Download….
- **Status bar**: watching / idle / conflicts, and online PLCs. Click it for all rung actions.
- **CodeLens** above each block header: Compile · Test · Open in TIA Portal. Editor title buttons do the same.
- **Testing view**: the YAML tests (`tests/**/*.test.yaml`) and their cases, run on rung's offline simulator. A failed expectation shows on its step's line, expected and actual side by side.
- **Live Values** in the rung sidebar: the values you pin (PLC tags, DB members), read twice a second while the view is open, each with its age and a short history line, read-only; integers in decimal, hex or binary, and a flight recorder that keeps the last ten minutes with your bookmarks for a CSV or a unit test (pin an FB's inputs and outputs through its instance DB; the test sets the inputs as they changed on the machine and expects the outputs as they settled).
- **Monitor Values** (the eye in the editor title): the values of the open block at the end of each line, read twice a second from the PLC's Web API or from `rung simulate`, read-only.
- **Problems** from `rung compile`, with file and line.
- **Debug Test** in the Testing view: breakpoints in SCL, step back, the block's variables, and **Why?** on any value (the statement that wrote it, its operands then, the branch that ran). **Run with Coverage**, **Record Expectations**.
- **Changes** and **Activity** views: what a sync would do before it runs, and what the watch did (sends, compiles, refusals), with conflicts in VS Code's merge editor.
- **Format Document** as TIA Portal writes SCL, TIA Portal's type rules while typing, semantic highlighting and the call hierarchy.

## Going online

You do not have to set up a connection first. *Go online* runs `rung online`, which finds the PLC on the network by the addresses in the TIA project and saves the connection as `[plc.<name>]` in `rung.toml`. When rung cannot decide on its own:

- **Several interfaces reach the PLC** (or only a device under another address answers): a list shows what answered; the one you choose is saved with `rung connect --use …` and the action runs again.
- **Nothing answers**: a dialog shows rung's explanation (the PLC's addresses, the PG/PC interfaces searched, what to check), with *Retry*, *Choose manually* (every PG/PC interface TIA Portal offers on this PC, from `rung interfaces`) and *Show details*.

*Connect…* (`Alt+Q C`, or click the connection in the PLC view) looks again and lets you change the connection at any time. A download does the same before its confirmation dialog, so the dialog always names the connection it uses.

## Setup

Nothing else to install: when no rung is on PATH, the extension uses the one it brings and runs it with VS Code's Node.js. It keeps that copy in its own storage folder, where it stays across updates. To use rung in a terminal or from an AI agent too, run **rung: Put rung on PATH** (or click it in the Environment view); that asks first.

A `rung` you installed yourself wins when it is on PATH. To use another one, point the extension at it:

```json
"rung.command": ["node", "C:/path/to/rung/packages/cli/dist/index.js"]
```

Open the folder with `rung.toml`. No `rung.toml` yet? The Project view offers *Initialize from a TIA Portal project*, which runs `rung init --project <file.ap20>` and then `rung pull`. rung writes nothing into the project until you click *Writes to TIA Portal* in the PLC view (`rung writes on`); until then TIA Portal's changes come into the files and your edits stay in them.

## Keys

`Alt+Q`, then a letter (same letters as the Zed tasks):

| key | action | key | action |
| --- | --- | --- | --- |
| `S` | sync | `O` | go online |
| `W` | start / stop watch | `F` | go offline |
| `B` | compile this file | `I` | interfaces |
| `Shift+B` | compile PLC | `D` | download (asks first) |
| `H` | compile hardware | `C` | connect (choose the connection) |
| `T` | test this block | `E` | open in TIA Portal |
| `Shift+T` | test all | `P` | pull |
| | | `Q` | list of rung actions |

## Downloads

A download changes a running machine, so it is never started by CodeLens, on save, or without a dialog:

1. Without a connection in `rung.toml`, the PLC is looked for first (see *Going online*).
2. A warning dialog names the PLC, what is downloaded (software, hardware, all blocks), the connection, and which TIA questions will be answered "yes".
3. You type the PLC name (setting `rung.download.confirmation`, user settings only).
4. `rung download --yes …` runs in its own terminal, where you see every question TIA Portal asks and rung's answer.
5. If TIA cancels because it wants to, say, stop the CPU, the extension asks whether to retry allowing exactly that, with the same typed confirmation.

`rung.download.allow` is empty by default; keep it that way unless you know why.

## Settings

All under `rung.*`: the command, auto-start of watch, terminal reuse, output verbosity, CodeLens, compile on save, status bar, project view grouping and read-only objects, online state refresh interval (off by default, only while watch runs), and download defaults (hardware, all blocks, start after, allow).

## Development

```
npm install
npm run build        # type check + bundle to out/extension.js
npm run package      # rung-scl.vsix
npm run test:e2e     # integration tests in a real VS Code (see below)
```

Unit tests (no VS Code) run from the repository root: `pnpm vitest run editors/vscode`.

`npm run test:e2e` starts VS Code as an Extension Development Host with a throwaway user data and extensions folder and other extensions turned off (the installed VS Code, else a downloaded one; `VSCODE_EXE` picks another). It runs three suites: *fresh* (a folder without `rung.toml`: initialize and pull), *fake* (a mirrored project on `packages/cli/test/fake-bridge.mjs`: views, status bar, CodeLens, every command, compile → Problems, watch, online and connection picking, download) and *tia* (the workspace `%TEMP%\rung-probe-ws`, bound to a TIA Portal V20 fixture project; skipped when TIA Portal does not answer). `RUNG_E2E_SUITES=fake` runs one suite, `RUNG_E2E_GREP=download` only matching tests. The CLI is `rung` from PATH, built with `pnpm -s tsc -b` at the repository root.

The extension is MIT licensed; the rung CLI it starts has its own license.
