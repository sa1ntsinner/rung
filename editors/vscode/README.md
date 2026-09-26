# rung for VS Code

SCL editing and TIA Portal sync for [rung](https://github.com/sa1ntsinner/rung). The extension is a front end for the `rung` CLI: every button runs a `rung` command, so what you do here is what you would type in a terminal.

## What you get

- **Language support** for `.scl`, `.db`, `.udt`, `.awl` (and TwinCAT / plain IEC ST files): highlighting, completion, hover, go to definition, references, rename of locals, outline, and diagnostics from the parser and from TIA Portal compiles.
- **rung sidebar** (the ladder-rung icon in the activity bar):
  - *Project*: the mirrored objects from `.rung/state.json`, by PLC, kind and TIA folder (or by block type). Conflicts, local or TIA changes and read-only objects are marked. Click to open; right-click to compile, test, open in TIA Portal or resolve a conflict.
  - *PLC*: whether `rung watch` runs (start/stop), each PLC with its online state and connection, and Go online, Go offline, Compile PLC, Compile hardware, Interfaces…, Download….
- **Status bar**: watching / idle / conflicts, and online PLCs. Click it for all rung actions.
- **CodeLens** above each block header: Compile · Test · Open in TIA Portal. Editor title buttons do the same.
- **Problems** from `rung compile`, with file and line.

## Setup

Install the CLI and put `rung` on PATH, or point the extension at it:

```json
"rung.command": ["node", "C:/path/to/rung/packages/cli/dist/index.js"]
```

Open the folder with `rung.toml`. No `rung.toml` yet? The Project view offers *Initialize from a TIA Portal project*, which runs `rung init --project <file.ap20>` and then `rung pull`.

## Keys

`Alt+Q`, then a letter (same letters as the Zed tasks):

| key | action | key | action |
| --- | --- | --- | --- |
| `S` | sync | `O` | go online |
| `W` | start / stop watch | `F` | go offline |
| `B` | compile this file | `I` | interfaces |
| `Shift+B` | compile PLC | `D` | download (asks first) |
| `H` | compile hardware | `E` | open in TIA Portal |
| `T` | test this block | `P` | pull |
| `Shift+T` | test all | `Q` | list of rung actions |

## Downloads

A download changes a running machine, so it is never started by CodeLens, on save, or without a dialog:

1. A warning dialog names the PLC, what is downloaded (software, hardware, all blocks), the connection, and which TIA questions will be answered "yes".
2. You type the PLC name (setting `rung.download.confirmation`, user settings only).
3. `rung download --yes …` runs in its own terminal, where you see every question TIA Portal asks and rung's answer.
4. If TIA cancels because it wants to, say, stop the CPU, the extension asks whether to retry allowing exactly that, with the same typed confirmation.

`rung.download.allow` is empty by default; keep it that way unless you know why.

## Settings

All under `rung.*`: the command, auto-start of watch, terminal reuse, output verbosity, CodeLens, compile on save, status bar, project view grouping and read-only objects, online state refresh interval (off by default, only while watch runs), and download defaults (hardware, all blocks, start after, allow).

The extension is MIT licensed; the rung CLI it starts has its own license.
