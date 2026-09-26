# Quickstart

rung turns a Siemens TIA Portal project into a folder of text files that stays in sync with TIA Portal, so you can work on it in VS Code, Zed or Neovim, keep it in git, and let AI agents help.

## 1. Install

- Windows with **TIA Portal V20** and the Openness option (installed with TIA Portal).
- Your Windows user in the local group **Siemens TIA Openness** (once, as administrator):
  `net localgroup "Siemens TIA Openness" %USERNAME% /add`, then sign out and in.
- Unzip `rung-<version>-win-x64.zip`, add the folder to `PATH`.

## 2. Mirror a project

Open the project in TIA Portal. In an empty folder:

```
rung init          # binds this folder to the open project
rung pull          # exports blocks, UDTs, tag tables into plc/<PLC>/...
git init && git add -A && git commit -m "baseline"
```

The first connection shows TIA Portal's *Openness access* dialog — allow it.

## 3. Work two-way

```
rung watch         # keeps both sides in sync; Ctrl+C to stop
```

- Edit `plc/PLC_1/blocks/.../Fx_Motor.scl` in your editor → rung imports it into TIA Portal, compiles it, and rewrites the file in TIA's formatting. Compile errors show up in the editor.
- Change a block in TIA Portal → the file updates.
- Both changed → non-overlapping edits merge; overlapping ones produce `Fx_Motor.scl.conflict`; finish with `rung resolve <file> --ours|--theirs|--merged`.
- Delete a file → rung asks for `rung confirm-delete <address>` before deleting anything in TIA Portal.
- Protected, failsafe, system and GRAPH blocks are read-only. rung never downloads to a PLC.

## 4. Editors and agents

- VS Code: install `editors/rung-scl.vsix`. Zed and Neovim: see [editors](editors/README.md).
- Claude Code: `claude mcp add rung -- rung mcp` or the plugin in `agents/`. Codex/Cursor: see [agents](agents/README.md).

## 5. More

- `rung test` — unit tests for SCL blocks on an offline simulator ([testing](testing.md)).
- `rung views` — read-only YAML views of hardware, HMI and technology objects.
- `rung live read '"DB".x'` — read live values over the S7-1500 Web API (read-only).
- `rung status`, `rung sync`, `rung agents`, `rung doctor --fixture`.
