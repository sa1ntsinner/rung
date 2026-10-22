# Agent permission modes

Without a mode, an agent may do on a PLC what the person can: download, live writes, RUN/STOP, `rung writes on`. A mode is a restriction the person chooses when they want one. Modes belong to an absolute workspace root; a PLC entry, named by its device name, overrides the workspace default. Workspace paths are compared without case on Windows.

| Mode | What happens |
|---|---|
| `manual` | PLC changes are refused. The person runs the command in their own terminal. |
| `ask` | Each action waits for a native dialog outside the agent. The person must type the exact PLC name to allow it once. |
| `auto` | Listed actions run without asking; other actions use the same dialog as `ask`. Without `--actions`, the list is `download,write,run-stop`. |
| `bypass` | Every action runs without asking. This is what happens without a mode. |

**The person who lets an agent work on a PLC is responsible for what it does there.** rung does not decide that for you: choose `manual`, `ask` or `auto` for the PLCs where you want a restriction, or set `read_only = true` / `RUNG_READ_ONLY=1` to keep a PLC out of reach for everyone.

## Choose a mode

Run these commands in your own terminal, in the workspace:

```sh
rung agent-mode
rung agent-mode --json
rung agent-mode ask
rung agent-mode auto --plc PLC_1 --actions download,write,run-stop --for 8h
rung agent-mode manual --plc PLC_1
rung agent-mode reset --plc PLC_1
rung agent-mode reset
```

Showing modes lists each PLC's effective mode, source and expiry. Setting or resetting a PLC entry requires typing that PLC's name on the terminal; changing the workspace default requires the workspace folder name. An agent cannot change modes or edit the store. When an action is refused, the agent asks the person and keeps the refusal intact.

Without `--for`, an entry lasts until you change it. `--for 8h` adds an ISO expiry time. On expiry, rung restores the entry's `previous` mode; if no previous entry remains, the workspace mode applies, or none. Reset removes that scope's entry.

The store lives outside the workspace: `%APPDATA%\rung\agent-modes.toml` on Windows; `$XDG_CONFIG_HOME/rung/agent-modes.toml` or `~/.config/rung/agent-modes.toml` on Linux and macOS. Do not put it in the project or have an agent write it.

## Actions and confirmation

| Action | Commands it covers |
|---|---|
| `download` | Download to the PLC |
| `write` | Live modify/write |
| `force` | Force/unforce |
| `run-stop` | RUN/STOP |
| `alarm-ack` | Alarm ack/acknowledge/reset |
| `writes-on` | `rung writes on`, `rung init --writes` |
| `openness-setup` | `rung setup openness` |
| `bridge` | Raw `rung bridge` |

Force and alarm acknowledgement are permission names. This release does not expose these operations; force tables remain read-only.

The `ask` dialog shows the action, PLC, agent marker and command line. Windows uses a PowerShell native dialog, macOS uses `osascript`, and Linux uses `zenity` or `kdialog`. If neither Linux dialog program is available, rung refuses and says why. Cancel, a different name, or 120 seconds without an answer refuses the action. The answer comes from the dialog child process, never the agent's stdin.

In `auto` and `bypass`, permission replaces the agent's typed PLC-name confirmation for download, live write and RUN/STOP. A person running the same command still confirms as before. Downloads answer TIA Portal's questions only as `--allow` permits: a mode does not approve STOP, DB reinitialisation or other TIA questions.

## Locks and records

Read-only always wins: `read_only = true` for a PLC, `RUNG_READ_ONLY=1`, and the other existing read-only locks refuse a change with their usual message in every mode. Modes do not remove object protection, connection permissions or other command checks.

Each PLC command an agent runs, with or without a mode and including a refusal in `manual`, appends to `.rung/agent-actions.jsonl`: time, agent marker, PLC, action, mode, whether permission came from the mode or dialog, and outcome as an exit code. A permitted action is written twice with one `id`: `"outcome": "started"` before it runs, then its exit code, so an action whose process was killed still shows (Activity says "did not finish"). Keep this record with the workspace when investigating a change.

## Editors and MCP

VS Code shows the mode you chose in its status bar; without one it shows nothing. Click it or run **rung: Agent Mode…** to choose a mode, PLC, `auto` actions and duration. The CLI opens in a terminal where you type the confirmation name.

Neovim's `:Rung agent-mode [...]` opens a terminal, and its statusline component shows the mode you chose. Zed offers **rung: agent mode (show)**; set modes in your own terminal.

MCP `rung_status` reports `agentModes` per PLC with source, expiry, `allowedActions` (without asking), `asksFor` (native dialog), and any read-only lock. Agents check the effective mode before acting, never change it themselves, and ask the person when refused. The MCP server still prepares download requests rather than downloading itself.
